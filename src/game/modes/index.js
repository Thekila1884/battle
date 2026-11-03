import admiral from "./admiral.js";
import blitz from "./blitz.js";
import boss from "./boss.js";
import campaign from "./campaign.js";
import chaos from "./chaos.js";
import classic from "./classic.js";
import fog from "./fog.js";
import points from "./points.js";
import puzzle from "./puzzle.js";
import revenge from "./revenge.js";
import storm from "./storm.js";
import teams from "./teams.js";
import treasure from "./treasure.js";

export const modes = [
  classic,
  storm,
  teams,
  points,
  blitz,
  boss,
  admiral,
  campaign,
  puzzle,
  treasure,
  fog,
  revenge,
  chaos,
];

export const modeById = Object.fromEntries(modes.map((mode) => [mode.id, mode]));
