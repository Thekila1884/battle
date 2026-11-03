import "./styles.css";
import { connectFirebase, firebaseConfigured, waitForDatabase } from "./firebase.js";
import {
  canStart,
  createRoomState,
  distance,
  MAX_PLAYERS,
  nextPlayer,
  resolveRound,
  startGame,
  validPlan,
  weapons,
  BOARD_SIZE,
} from "./game/engine.js";
import { modeById, modes } from "./game/modes/index.js";
import {
  onValue,
  ref,
  runTransaction,
  update,
} from "@firebase/database";

const app = document.querySelector("#app");
const palette = ["#c9fb67", "#80d9ff", "#ff8b76", "#c5a1ff", "#ffd16f", "#ff8bc5", "#77e4ba", "#f38dff"];
const playableModes = modes.filter((mode) => mode.id === "classic" || mode.id === "storm");

let connection;
let roomCode = "";
let userName = "";
let room = null;
let currentPlan = { move: null, targetId: null, weaponId: "pulse" };
let unsubscribeRoom = null;
let notice = "";
let busy = false;

render();

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.matches("[data-create-form]")) void createRoom(form);
  if (form.matches("[data-join-form]")) void joinRoom(form);
});

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target) void handleAction(target.dataset.action, target);
  const cell = event.target.closest("[data-cell]");
  if (cell) selectCell(Number(cell.dataset.x), Number(cell.dataset.y));
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches("[data-mode-select]")) void updateMode(target.value);
  if (target.matches("[data-weapon-select]")) {
    currentPlan.weaponId = target.value;
    render();
  }
});

async function ensureConnection() {
  if (!firebaseConfigured) {
    throw new Error("Configura Firebase para crear o unirte a una sala en línea.");
  }
  if (!connection) {
    const initialized = await connectFirebase();
    await waitForDatabase(initialized.database);
    connection = initialized;
  }
  return connection;
}

async function createRoom(form) {
  const data = new FormData(form);
  userName = cleanName(data.get("name"));
  const modeId = String(data.get("mode") || "classic");
  if (!userName) return showNotice("Escribe un nombre de piloto.");
  busy = true;
  render();
  try {
    const { database, user } = await ensureConnection();
    const state = createRoomState({ host: { uid: user.uid, name: userName }, modeId });
    const code = await reserveRoom(database, state);
    enterRoom(database, code, user.uid);
  } catch (error) {
    showNotice(error.message);
  } finally {
    busy = false;
    render();
  }
}

async function joinRoom(form) {
  const data = new FormData(form);
  userName = cleanName(data.get("name"));
  const code = String(data.get("code") || "").trim().toUpperCase();
  if (!userName) return showNotice("Escribe un nombre de piloto.");
  if (!/^[A-Z0-9]{6}$/.test(code)) return showNotice("El código debe tener 6 letras o números.");
  busy = true;
  render();
  try {
    const { database, user } = await ensureConnection();
    const roomRef = ref(database, `rooms/${code}`);
    let joinFailure = "";
    await new Promise((resolve, reject) => {
      let transactionStarted = false;
      let unsubscribe = () => {};

      unsubscribe = onValue(
        roomRef,
        (snapshot) => {
          if (transactionStarted) return;
          if (!snapshot.exists()) {
            unsubscribe();
            reject(new Error("La sala no existe."));
            return;
          }

          transactionStarted = true;
          void runTransaction(roomRef, (current) => {
            if (!current) {
              joinFailure = "La sala ya no está disponible.";
              return;
            }
            if (current.players?.[user.uid]) {
              joinFailure = "Esta cuenta ya está en la sala.";
              return;
            }
            if (current.status !== "lobby") {
              joinFailure = "La partida ya empezó.";
              return;
            }
            if (Object.keys(current.players ?? {}).length >= MAX_PLAYERS) {
              joinFailure = "La sala está llena.";
              return;
            }
            joinFailure = "";
            return nextPlayer(current, user.uid, userName);
          }).then(
            (result) => {
              unsubscribe();
              if (!result.committed) {
                reject(new Error(joinFailure || "No se pudo completar la entrada a la sala."));
                return;
              }
              resolve(result);
            },
            (error) => {
              unsubscribe();
              reject(error);
            }
          );
        },
        (error) => {
          unsubscribe();
          reject(new Error(`No se pudo leer la sala: ${error.message}`));
        }
      );
    });
    enterRoom(database, code, user.uid);
  } catch (error) {
    showNotice(error.message);
  } finally {
    busy = false;
    render();
  }
}

async function reserveRoom(database, initialState) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const result = await runTransaction(ref(database, `rooms/${code}`), (current) => current ?? initialState);
    if (result.committed && result.snapshot.val()?.hostId === initialState.hostId) return code;
  }
  throw new Error("No se pudo reservar un código de sala. Inténtalo otra vez.");
}

function enterRoom(database, code, uid) {
  roomCode = code;
  currentPlan = { move: null, targetId: null, weaponId: "pulse" };
  unsubscribeRoom?.();
  unsubscribeRoom = onValue(ref(database, `rooms/${code}`), (snapshot) => {
    room = snapshot.val();
    if (!room || !room.players?.[uid]) {
      leaveRoom();
      showNotice("La sala se cerró o ya no tienes acceso.");
      return;
    }
    render();
    if (room.hostId === uid && room.status === "playing") void hostResolveIfReady(database, uid);
  }, (error) => showNotice(`Error de Firebase: ${error.message}`));
  render();
}

async function hostResolveIfReady(database, uid) {
  if (!room || !canResolve(room, uid)) return;
  const roomRef = ref(database, `rooms/${roomCode}`);
  const result = await runTransaction(roomRef, (current) => {
    if (!current || !canResolve(current, uid)) return;
    return resolveRound(current);
  });
  if (!result.committed) return;
}

function canResolve(state, uid) {
  const active = Object.values(state.players ?? {}).filter((player) => player.alive);
  return state.status === "playing" &&
    state.hostId === uid &&
    active.length > 0 &&
    active.every((player) => Boolean(state.plans?.[player.uid]));
}

async function handleAction(action, element) {
  if (action === "dismiss-notice") {
    notice = "";
    render();
    return;
  }
  if (action === "copy-code") {
    try {
      await navigator.clipboard.writeText(roomCode);
      showNotice("Código copiado. ¡Pásalo a tu escuadra!");
    } catch {
      showNotice(`Código de sala: ${roomCode}`);
    }
    return;
  }
  if (action === "leave") {
    await exitRoom();
    return;
  }
  if (!room) return;
  try {
    const { database, user } = await ensureConnection();
    const roomRef = ref(database, `rooms/${roomCode}`);
    if (action === "ready") {
      await update(ref(database, `rooms/${roomCode}/players/${user.uid}`), { ready: true });
    } else if (action === "start") {
      const result = await runTransaction(roomRef, (current) => {
        if (!canStart(current, user.uid)) return;
        return startGame(current);
      });
      if (!result.committed) showNotice("Se necesitan dos pilotos y que todos estén listos.");
    } else if (action === "submit-plan") {
      await submitPlan(database, user.uid, element);
    }
  } catch (error) {
    showNotice(error.message);
  }
}

async function submitPlan(database, uid, button) {
  const player = room.players[uid];
  const plan = {
    move: currentPlan.move ?? { x: player.x, y: player.y },
    targetId: currentPlan.targetId,
    weaponId: currentPlan.weaponId,
  };
  if (room.modeId !== "boss" && !plan.targetId) {
    showNotice("Selecciona un rival como objetivo.");
    return;
  }
  if (!validPlan({ ...plan, move: plan.move }, { ...player, x: player.x, y: player.y })) {
    showNotice("El movimiento no es válido: solo puedes avanzar una casilla.");
    return;
  }
  const target = room.players[plan.targetId];
  const weapon = weapons.find((item) => item.id === plan.weaponId);
  if (room.modeId !== "boss" && target && distance(plan.move, target) > weapon.range + 1) {
    showNotice("Ese rival está fuera del alcance de tu arma.");
    return;
  }
  button.disabled = true;
  const result = await runTransaction(ref(database, `rooms/${roomCode}`), (current) => {
    if (!current || current.status !== "playing" || current.plans?.[uid]) return;
    if (!current.players?.[uid]?.alive) return;
    current.plans ??= {};
    current.plans[uid] = plan;
    current.logs = [...(current.logs ?? []), `${current.players[uid].name} confirmó su jugada.`].slice(-30);
    return current;
  });
  if (!result.committed) showNotice("No se pudo enviar la jugada. Comprueba el estado de la ronda.");
  else currentPlan = { move: null, targetId: null, weaponId: "pulse" };
}

async function updateMode(modeId) {
  if (!room || !playableModes.some((mode) => mode.id === modeId)) return;
  try {
    const { database, user } = await ensureConnection();
    const result = await runTransaction(ref(database, `rooms/${roomCode}`), (current) => {
      if (!current || current.hostId !== user.uid || current.status !== "lobby") return;
      current.modeId = modeId;
      current.players = Object.fromEntries(
        Object.entries(current.players).map(([uid, player], index) => [
          uid,
          { ...player, team: modeById[modeId].teamPlay ? (index % 2 === 0 ? "A" : "B") : null },
        ])
      );
      current.bossHp = modeId === "boss" ? 280 : null;
      current.logs = [...(current.logs ?? []), `Modo seleccionado: ${modeById[modeId].label}.`].slice(-30);
      return current;
    });
    if (!result.committed) showNotice("Solo quien creó la sala puede cambiar el modo.");
  } catch (error) {
    showNotice(error.message);
  }
}

function selectCell(x, y) {
  if (!room || room.status !== "playing") return;
  const ownPlayer = room.players[connection.user.uid];
  if (!ownPlayer?.alive || room.plans?.[connection.user.uid]) return;
  const target = Object.values(room.players).find((player) => player.alive && player.x === x && player.y === y);
  if (target && target.uid !== ownPlayer.uid) {
    if (modeById[room.modeId]?.teamPlay && ownPlayer.team === target.team) {
      showNotice("No puedes atacar a tu compañero.");
      return;
    }
    currentPlan.targetId = target.uid;
  } else if (Math.abs(x - ownPlayer.x) + Math.abs(y - ownPlayer.y) <= 1) {
    currentPlan.move = { x, y };
  }
  render();
}

function leaveRoom() {
  unsubscribeRoom?.();
  unsubscribeRoom = null;
  roomCode = "";
  room = null;
  currentPlan = { move: null, targetId: null, weaponId: "pulse" };
}

async function exitRoom() {
  if (!roomCode || !connection) {
    leaveRoom();
    render();
    return;
  }

  const uid = connection.user.uid;
  try {
    await runTransaction(ref(connection.database, `rooms/${roomCode}`), (current) => {
      if (!current) return null;

      if (current.status === "lobby") {
        delete current.players?.[uid];
        const remaining = Object.keys(current.players ?? {});
        if (remaining.length === 0) return null;
        if (current.hostId === uid) current.hostId = remaining[0];
      } else {
        const departingPlayer = current.players?.[uid];
        if (departingPlayer) departingPlayer.alive = false;
        if (current.plans) delete current.plans[uid];
        const remaining = Object.values(current.players ?? {}).filter((player) => player.alive);
        if (current.hostId === uid) current.hostId = remaining[0]?.uid ?? Object.keys(current.players ?? {})[0];
        if (remaining.length === 0) {
          current.status = "finished";
          current.winner = "draw";
        } else if (
          remaining.length === 1 &&
          !modeById[current.modeId]?.points &&
          !modeById[current.modeId]?.roundLimit &&
          !modeById[current.modeId]?.boss
        ) {
          current.status = "finished";
          current.winner = modeById[current.modeId]?.teamPlay ? remaining[0].team : remaining[0].uid;
        }
      }

      const departingName = room?.players?.[uid]?.name ?? "Un piloto";
      current.logs = [...(current.logs ?? []), `${departingName} salió de la sala.`].slice(-30);
      return current;
    });
    leaveRoom();
    render();
  } catch (error) {
    showNotice(`No se pudo salir de la sala: ${error.message}`);
  }
}

function showNotice(message) {
  notice = message;
  render();
}

function cleanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 18);
}

function render() {
  app.innerHTML = room ? renderRoom() : renderHome();
}

function renderHome() {
  const setupWarning = firebaseConfigured ? "" : `
    <div class="setup-note">
      <span class="setup-dot"></span>
      <span><strong>Firebase aún no está conectado.</strong> Completa <code>.env.local</code> para habilitar las salas en línea.</span>
    </div>`;
  return `
    <main class="site-shell">
      <header class="topbar">
        <a class="brand" href="#" aria-label="Battleweb inicio"><span class="brand-mark">B</span><span>BATTLE<span class="brand-light">WEB</span></span></a>
        <div class="topbar-right"><span class="online-indicator"></span><span>ARENA EN LÍNEA</span><span class="topbar-divider"></span><span>v0.1 — BETA</span></div>
      </header>
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow"><span class="eyebrow-line"></span> ESTRATEGIA. INSTINTO. SUPERVIVENCIA.</div>
          <h1>La arena<br />es <em>tuya.</em></h1>
          <p class="hero-description">Elige tu movimiento. Fija el objetivo. Todo ocurre a la vez. ¿Te adelantarás a los demás?</p>
          <div class="hero-meta"><span><span class="meta-icon">◈</span> 2–8 PILOTOS</span><span><span class="meta-icon">◷</span> 5–10 MIN</span><span><span class="meta-icon">⌘</span> RONDAS SIMULTÁNEAS</span></div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
          <div class="hero-crosshair">+</div><div class="hero-coordinate">04 : 04<br /><span>SECTOR CENTRAL</span></div>
          <div class="hero-target"><span></span></div><div class="hero-ship ship-one">▲</div><div class="hero-ship ship-two">◆</div><div class="hero-ship ship-three">▲</div>
          <div class="hero-blip blip-one"></div><div class="hero-blip blip-two"></div><div class="hero-blip blip-three"></div>
        </div>
      </section>
      ${setupWarning}
      ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}<button data-action="dismiss-notice" aria-label="Cerrar">×</button></div>` : ""}
      <section class="play-section">
        <div class="section-heading"><span class="section-index">01 / CONECTA</span><span class="section-rule"></span><span class="section-caption">REÚNE A TU ESCUADRA</span></div>
        <div class="play-cards">
          <article class="play-card create-card">
            <div class="card-topline"><span class="card-icon">↗</span><span class="card-label">ANFITRIÓN</span></div>
            <h2>Crea una sala</h2><p>Elige las reglas y comparte tu código de invitación.</p>
            <form data-create-form class="card-form">
              <label class="sr-only" for="create-name">Tu nombre</label><input id="create-name" name="name" maxlength="18" placeholder="Tu nombre de piloto" autocomplete="nickname" required />
              <label class="select-wrap"><span class="sr-only">Modo de juego</span><select name="mode">${playableModes.map((mode) => `<option value="${mode.id}">${escapeHtml(mode.label)} — ${escapeHtml(mode.description)}</option>`).join("")}</select><span class="select-chevron">⌄</span></label>
              <button class="button button-primary" type="submit" ${busy || !firebaseConfigured ? "disabled" : ""}><span>${busy ? "CONECTANDO…" : "CREAR SALA"}</span><span class="button-arrow">↗</span></button>
            </form>
            <div class="card-footnote"><span>◉</span> Partida privada · Hasta ${MAX_PLAYERS} pilotos</div>
          </article>
          <article class="play-card join-card">
            <div class="card-topline"><span class="card-icon join-icon">⌁</span><span class="card-label">INVITADO</span></div>
            <h2>Únete a una sala</h2><p>¿Ya tienes un código? Entra directo a la batalla.</p>
            <form data-join-form class="card-form">
              <label class="sr-only" for="join-name">Tu nombre</label><input id="join-name" name="name" maxlength="18" placeholder="Tu nombre de piloto" autocomplete="nickname" required />
              <label class="sr-only" for="room-code">Código de sala</label><input id="room-code" class="code-input" name="code" maxlength="6" placeholder="CÓDIGO" autocomplete="off" required />
              <button class="button button-secondary" type="submit" ${busy || !firebaseConfigured ? "disabled" : ""}><span>ENTRAR A LA SALA</span><span class="button-arrow">→</span></button>
            </form>
            <div class="card-footnote"><span>◉</span> Sin descargas · Juega desde el navegador</div>
          </article>
        </div>
      </section>
      <section class="how-section">
        <div class="section-heading"><span class="section-index">02 / DOMINA</span><span class="section-rule"></span><span class="section-caption">FÁCIL DE APRENDER. DIFÍCIL DE ANTICIPAR.</span></div>
        <div class="steps">
          <div class="step"><span class="step-number">01</span><div><h3>Planea</h3><p>Muévete una casilla y elige tu arma.</p></div></div>
          <div class="step"><span class="step-number">02</span><div><h3>Apunta</h3><p>Fija un objetivo antes de que acabe la ronda.</p></div></div>
          <div class="step"><span class="step-number">03</span><div><h3>Resuelve</h3><p>Cuando todos confirman, la arena responde.</p></div></div>
        </div>
      </section>
      <footer class="footer"><span>© 2026 BATTLEWEB</span><span>HECHO PARA JUGAR EN EQUIPO <span class="footer-star">✳</span></span><span>WEB MULTIJUGADOR</span></footer>
    </main>`;
}

function renderRoom() {
  const currentUser = connection?.user?.uid;
  const me = room.players?.[currentUser];
  if (!me) return renderHome();
  if (room.status === "lobby") return renderLobby(me, currentUser);
  return renderGame(me, currentUser);
}

function renderLobby(me, uid) {
  const players = Object.values(room.players ?? {});
  const mode = modeById[room.modeId] ?? modeById.classic;
  const canLaunch = canStart(room, uid);
  return `
    <main class="site-shell room-shell">
      <header class="topbar"><a class="brand" href="#" data-action="leave"><span class="brand-mark">B</span><span>BATTLE<span class="brand-light">WEB</span></span></a><button class="text-button" data-action="leave">SALIR DE LA SALA ↗</button></header>
      ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}<button data-action="dismiss-notice" aria-label="Cerrar">×</button></div>` : ""}
      <section class="lobby-header"><div><div class="eyebrow"><span class="eyebrow-line"></span> PREPARACIÓN DE ESCUADRA</div><h1>La sala está <em>abierta.</em></h1><p>Reúne a tus pilotos. El anfitrión inicia cuando todos estén listos.</p></div><div class="room-code-box"><span>CÓDIGO DE INVITACIÓN</span><button class="room-code" data-action="copy-code">${roomCode}<span>▣</span></button><small>TOCA PARA COPIAR</small></div></section>
      <section class="lobby-grid">
        <article class="lobby-panel roster-panel"><div class="panel-heading"><span>ESCUADRA</span><span>${players.length.toString().padStart(2, "0")} / ${MAX_PLAYERS}</span></div>
          <div class="roster">${players.map((player, index) => `<div class="roster-player"><span class="player-avatar" style="--player-color:${palette[index % palette.length]}">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><div class="roster-name"><strong>${escapeHtml(player.name)}${player.uid === uid ? ' <span class="you-tag">TÚ</span>' : ""}${player.uid === room.hostId ? ' <span class="host-tag">HOST</span>' : ""}</strong><small>${mode.teamPlay ? `EQUIPO ${player.team}` : "PILOTO"}</small></div><span class="ready-status ${player.uid === uid || player.ready ? "is-ready" : ""}">${player.uid === uid || player.ready ? "LISTO" : "PREPARANDO"}</span></div>`).join("")}
          ${players.length < 2 ? `<div class="empty-player"><span>＋</span><div><strong>Esperando pilotos</strong><small>Comparte el código para empezar</small></div></div>` : ""}
          </div>
          ${me.uid !== room.hostId ? `<button class="button button-primary full-button" data-action="ready" ${me.ready ? "disabled" : ""}><span>${me.ready ? "YA ESTÁS LISTO" : "MARCARME LISTO"}</span><span class="button-arrow">✓</span></button>` : `<button class="button button-primary full-button" data-action="start" ${canLaunch ? "" : "disabled"}><span>${canLaunch ? "INICIAR PARTIDA" : players.length < 2 ? "ESPERANDO PILOTOS" : "ESPERANDO A LA ESCUADRA"}</span><span class="button-arrow">↗</span></button>`}
          <div class="lobby-hint"><span>✳</span> Comparte el código con tus amigos para que se unan.</div>
        </article>
        <aside class="lobby-side">
          <article class="lobby-panel mode-panel"><div class="panel-heading"><span>REGLAS DE LA ARENA</span><span>01</span></div>${me.uid === room.hostId ? `<label class="mode-select-wrap"><span class="sr-only">Modo de juego</span><select data-mode-select>${playableModes.map((item) => `<option value="${item.id}" ${item.id === room.modeId ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><span>⌄</span></label>` : `<h2>${escapeHtml(mode.label)}</h2>`}<p>${escapeHtml(mode.description)}</p><div class="mode-tags"><span>2–8 JUGADORES</span><span>${mode.storm ? "ZONA DINÁMICA" : "RONDAS SIMULTÁNEAS"}</span></div></article>
          <article class="lobby-panel briefing-panel"><div class="panel-heading"><span>ANTES DE CAER</span><span>✳</span></div><ul><li><span>01</span> Cada ronda, planea en secreto.</li><li><span>02</span> Muévete hasta una casilla adyacente.</li><li><span>03</span> Las acciones se resuelven al confirmar.</li></ul></article>
        </aside>
      </section>
      <footer class="footer"><span>© 2026 BATTLEWEB</span><span>SALA PRIVADA <span class="footer-star">✳</span></span><span>${roomCode}</span></footer>
    </main>`;
}

function renderGame(me, uid) {
  const players = Object.values(room.players ?? {});
  const mode = modeById[room.modeId] ?? modeById.classic;
  const myPlan = room.plans?.[uid];
  const selectedWeapon = weapons.find((weapon) => weapon.id === currentPlan.weaponId) ?? weapons[0];
  const target = room.players[currentPlan.targetId];
  const allSubmitted = players.filter((player) => player.alive).every((player) => room.plans?.[player.uid]);
  const cells = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const occupant = players.find((player) => player.alive && player.x === x && player.y === y);
      const isMe = occupant?.uid === uid;
      const visibleOccupant = occupant && (isMe || !mode.fog || currentPlan.targetId === occupant.uid);
      const isMove = currentPlan.move?.x === x && currentPlan.move?.y === y;
      const isTarget = currentPlan.targetId && occupant?.uid === currentPlan.targetId;
      const warning = mode.storm && room.stormWarningRadius !== null && outsideStorm({ x, y }, room.stormWarningRadius);
      const danger = mode.storm && outsideStorm({ x, y }, room.stormRadius);
      const treasure = mode.treasure && room.treasure?.x === x && room.treasure?.y === y;
      const classNames = ["board-cell", (x + y) % 2 ? "cell-alt" : "", isMe ? "cell-self" : "", visibleOccupant && !isMe ? "cell-enemy" : "", isMove ? "cell-move" : "", isTarget ? "cell-target" : "", warning ? "cell-warning" : "", danger ? "cell-danger" : "", treasure ? "cell-treasure" : ""].filter(Boolean).join(" ");
      cells.push(`<button class="${classNames}" data-cell data-x="${x}" data-y="${y}" aria-label="Casilla ${x + 1}, ${y + 1}${occupant ? `: ${escapeHtml(visibleOccupant ? occupant.name : "señal en la niebla")}` : ""}">
        ${danger ? '<span class="storm-mark">✳</span>' : ""}
        ${treasure ? '<span class="treasure-mark">◆</span>' : ""}
        ${visibleOccupant ? `<span class="token" style="--player-color:${palette[players.findIndex((player) => player.uid === occupant.uid) % palette.length]}">${isMe ? "▲" : mode.fog ? "?" : occupant.name.slice(0, 1).toUpperCase()}</span>` : ""}
        ${isMove ? '<span class="move-mark">⌖</span>' : ""}
        ${isTarget ? '<span class="target-mark">⊕</span>' : ""}
      </button>`);
    }
  }
  const waitingCount = players.filter((player) => player.alive && room.plans?.[player.uid]).length;
  return `
    <main class="site-shell game-shell">
      <header class="topbar"><a class="brand" href="#" data-action="leave"><span class="brand-mark">B</span><span>BATTLE<span class="brand-light">WEB</span></span></a><div class="game-top-status"><span class="online-indicator"></span> PARTIDA EN CURSO <span class="topbar-divider"></span> ${escapeHtml(mode.label).toUpperCase()}</div><button class="text-button" data-action="leave">SALIR ↗</button></header>
      ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}<button data-action="dismiss-notice" aria-label="Cerrar">×</button></div>` : ""}
      <section class="game-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span> ${escapeHtml(mode.label.toUpperCase())} · SALA ${roomCode}</div><h1>Ronda <em>${room.round}</em></h1></div><div class="round-status"><span>${room.status === "finished" ? "PARTIDA FINALIZADA" : myPlan ? "JUGADA CONFIRMADA" : allSubmitted ? "RESOLVIENDO…" : "ESPERANDO JUGADAS"}</span><div class="round-dots">${players.map((player) => `<i class="${!player.alive ? "is-out" : room.plans?.[player.uid] ? "is-ready" : ""}" title="${escapeHtml(player.name)}"></i>`).join("")}</div></div></section>
      ${room.status === "finished" ? `<div class="winner-banner"><span>✳</span> ${room.winner === "draw" ? "EMPATE" : room.winner === room.hostId && mode.boss ? "¡EL JEFE FUE DERROTADO!" : mode.teamPlay ? `¡GANA EL EQUIPO ${escapeHtml(room.winner)}!` : `¡${escapeHtml(room.players[room.winner]?.name ?? "Ganador")} GANA LA ARENA!`}</div>` : ""}
      <section class="game-layout">
        <div class="arena-panel">
          <div class="arena-topline"><span><i class="arena-live"></i> ARENA EN VIVO</span><span>SECTOR 04 / 09</span></div>
          <div class="arena-wrap"><div class="y-axis">${Array.from({ length: BOARD_SIZE }, (_, index) => `<span>${BOARD_SIZE - index}</span>`).join("")}</div><div class="board-grid" role="grid" aria-label="Tablero táctico">${cells.join("")}</div><div class="x-axis">${Array.from({ length: BOARD_SIZE }, (_, index) => `<span>${String.fromCharCode(65 + index)}</span>`).join("")}</div></div>
          <div class="arena-legend"><span><i class="legend-self"></i> TÚ</span><span><i class="legend-enemy"></i> RIVAL</span>${mode.storm ? '<span><i class="legend-storm"></i> TORMENTA</span>' : ""}${mode.treasure ? '<span><i class="legend-treasure"></i> ALIJO</span>' : ""}<span class="legend-coordinates">9 × 9 · TABLERO TÁCTICO</span></div>
        </div>
        <aside class="game-sidebar">
          <article class="command-panel">
            <div class="panel-heading"><span>ÓRDENES DE RONDA</span><span>${myPlan ? "ENVIADAS" : "01"}</span></div>
            <div class="pilot-card"><span class="player-avatar" style="--player-color:${palette[players.findIndex((player) => player.uid === uid) % palette.length]}">${escapeHtml(me.name.slice(0, 1).toUpperCase())}</span><div class="pilot-info"><strong>${escapeHtml(me.name)} <span class="you-tag">TÚ</span></strong><div class="health-track"><span style="width:${me.hp}%;--health-color:${me.hp < 35 ? "#ff8174" : "#c9fb67"}"></span></div></div><strong class="health-value">${me.hp}<small> HP</small></strong></div>
            ${room.modeId === "boss" ? `<div class="boss-health">JEFE <span>${room.bossHp} HP</span><div class="health-track"><span style="width:${Math.max(0, room.bossHp / 2.8)}%;--health-color:#ff8174"></span></div></div>` : ""}
            <label class="control-label" for="weapon">ARMA</label><label class="weapon-select"><select id="weapon" data-weapon-select ${myPlan || room.status === "finished" ? "disabled" : ""}>${weapons.map((weapon) => `<option value="${weapon.id}" ${weapon.id === currentPlan.weaponId ? "selected" : ""}>${weapon.name} — ${weapon.damage} DMG</option>`).join("")}</select><span>⌄</span></label>
            <div class="weapon-stats"><span>ALCANCE <strong>${selectedWeapon.range} CAS.</strong></span><span>DAÑO <strong>${selectedWeapon.damage} HP</strong></span></div>
            <div class="order-summary"><span class="order-label">MOVIMIENTO</span><strong>${currentPlan.move ? `CASILLA ${String.fromCharCode(65 + currentPlan.move.x)}${BOARD_SIZE - currentPlan.move.y}` : "Mantienes posición"}</strong><small>Selecciona una casilla adyacente en el mapa.</small></div>
            <div class="order-summary"><span class="order-label">OBJETIVO</span><strong>${room.modeId === "boss" ? "JEFE CENTRAL" : target ? escapeHtml(target.name) : "Sin objetivo"}</strong><small>${mode.fog ? "La niebla oculta a tus rivales." : "Haz clic en un rival para fijarlo."}</small></div>
            <button class="button button-primary full-button" data-action="submit-plan" ${myPlan || room.status === "finished" || !me.alive ? "disabled" : ""}><span>${myPlan ? "ORDEN CONFIRMADA" : "CONFIRMAR ORDEN"}</span><span class="button-arrow">${myPlan ? "✓" : "↗"}</span></button>
            <div class="confirm-footnote">${myPlan ? "Tu jugada está oculta hasta la resolución." : `Confirma para resolver · ${waitingCount}/${players.filter((player) => player.alive).length} listos`}</div>
          </article>
          <article class="players-panel"><div class="panel-heading"><span>PILOTOS</span><span>${players.length.toString().padStart(2, "0")}</span></div><div class="mini-roster">${players.map((player, index) => `<div class="mini-player ${!player.alive ? "player-out" : ""}"><span class="mini-avatar" style="--player-color:${palette[index % palette.length]}">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span><span class="mini-name">${escapeHtml(player.name)}${player.uid === uid ? " · TÚ" : ""}</span><span class="mini-score">${player.alive ? `${player.hp} HP` : "FUERA"}</span><span class="mini-ready ${room.plans?.[player.uid] ? "is-ready" : ""}"></span></div>`).join("")}</div></article>
          <article class="event-panel"><div class="panel-heading"><span>SEÑALES DE ARENA</span><span>LIVE</span></div><div class="event-list">${(room.logs ?? []).slice(-4).reverse().map((entry) => `<p><span>›</span>${escapeHtml(entry)}</p>`).join("") || "<p>Sin actividad todavía.</p>"}</div></article>
        </aside>
      </section>
      <footer class="footer"><span>© 2026 BATTLEWEB</span><span>RONDA SIMULTÁNEA <span class="footer-star">✳</span></span><span>${roomCode}</span></footer>
    </main>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}
