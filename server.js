// server.js - Docker-friendly with viewer proxying
const express = require('express');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');
const socketIo = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const mcDataPkg = require('minecraft-data');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

const VIEWER_PORT_BASE = 3001;
const RECONNECT_INTERVAL_MS = 15000;

const botManager = { bots: {}, nextViewerPort: VIEWER_PORT_BASE };

function makeId() {
  return `bot_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function tryStartViewerForBot(entry) {
  if (!entry || !entry.bot) return;
  if (String(process.env.DISABLE_VIEWER || '').toLowerCase() === 'true') {
    console.log(`[${entry.state.id}] viewer disabled via DISABLE_VIEWER`);
    return;
  }
  const id = entry.state.id;
  try {
    require.resolve('canvas');
  } catch (cErr) {
    console.warn(`[${id}] node-canvas not present; skipping viewer: ${cErr && cErr.message}`);
    return;
  }
  let viewer;
  try {
    viewer = require('prismarine-viewer').mineflayer;
  } catch (err) {
    console.warn(`[${id}] prismarine-viewer require failed: ${err && err.message}`);
    return;
  }

  const port = entry.state.viewerPort;
  try {
    viewer(entry.bot, { port, firstPerson: true });
    console.log(`[${id}] prismarine-viewer started on internal port ${port}`);
    const route = `/viewer/${encodeURIComponent(id)}`;
    if (!entry._proxyRegistered) {
      app.use(route, createProxyMiddleware({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathReq) => pathReq.replace(new RegExp(`^${route}`), ''),
        logLevel: 'warn'
      }));
      app.use(`${route}/`, createProxyMiddleware({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathReq) => pathReq.replace(new RegExp(`^${route}`), ''),
        logLevel: 'warn'
      }));
      entry._proxyRegistered = true;
    }
  } catch (e) {
    console.warn(`[${id}] failed to start viewer on ${port}: ${e && e.message}`);
  }
}

function createBot({ host = 'Stackables.aternos.me', port = 39639, username, id } = {}) {
  id = id || makeId();
  username = username || id;
  const viewerPort = botManager.nextViewerPort++;
  const state = {
    id, connected: false, username, host, port,
    health: 0, maxHealth: 20, food: 20,
    position: { x: 0, y: 0, z: 0 },
    chat: [], controllingClientId: null, viewerPort
  };
  const entry = { bot: null, state, aiEnabled: true, reconnectInterval: null, aiIntervals: {} };
  botManager.bots[id] = entry;

  attemptCreateBot(id);

  entry.reconnectInterval = setInterval(() => {
    const cur = botManager.bots[id];
    if (!cur) return;
    if (!cur.bot || !cur.state.connected) attemptCreateBot(id);
  }, RECONNECT_INTERVAL_MS);

  emitAllStates();
  return id;
}

function attemptCreateBot(id) {
  const entry = botManager.bots[id];
  if (!entry) return;
  const { host, port, username } = entry.state;
  console.log(`Attempt create bot ${id} -> ${host}:${port} as ${username}`);
  try {
    const bot = mineflayer.createBot({ host, port, username, version: false });
    entry.bot = bot;
    bot.loadPlugin(pathfinder);

    bot.once('login', () => {
      console.log(`[${id}] logged in`);
      entry.state.connected = true;
      entry.state.username = bot.username;
      entry.aiEnabled = true;
      startAIActions(id);
      tryStartViewerForBot(entry);
      emitAllStates();
    });

    bot.on('spawn', () => setupBotEvents(id));
    bot.on('end', () => { entry.state.connected = false; entry.aiEnabled = false; stopAIActions(id); emitAllStates(); });
    bot.on('kicked', (reason) => { entry.state.connected = false; entry.aiEnabled = false; stopAIActions(id); emitAllStates(); });
    bot.on('error', (err) => { console.warn(`[${id}] bot error: ${err && err.message}`); entry.state.connected = false; entry.aiEnabled = false; stopAIActions(id); emitAllStates(); });
  } catch (err) {
    console.error(`[${id}] createBot error:`, err && err.message);
  }
}

function setupBotEvents(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot) return;
  const bot = entry.bot;

  bot.on('chat', (username, message) => {
    const full = `<${username}> ${message}`;
    entry.state.chat.push(full); if (entry.state.chat.length > 300) entry.state.chat.shift();
    if (message.trim().toLowerCase() === 'drop') dropEverything(id).catch(()=>{});
    emitAllStates();
  });

  bot.on('health', () => {
    entry.state.health = bot.health || entry.state.health;
    entry.state.maxHealth = bot.maxHealth || entry.state.maxHealth;
    entry.state.food = bot.food || entry.state.food;
    emitAllStates();
  });

  bot.on('move', () => {
    if (bot.entity && bot.entity.position) {
      entry.state.position = { x: bot.entity.position.x.toFixed(2), y: bot.entity.position.y.toFixed(2), z: bot.entity.position.z.toFixed(2) };
    }
  });

  bot.on('entityMoved', () => { if (entry.aiEnabled) checkAndAvoidHostiles(id); });
  bot.on('entitySpawn', () => { if (entry.aiEnabled) checkAndAvoidHostiles(id); });
}

async function dropEverything(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot || !entry.bot.inventory) return;
  const bot = entry.bot;
  entry.aiEnabled = false; stopAIActions(id);
  try {
    const items = bot.inventory.items();
    for (const item of items) {
      try { await bot.tossStack(item); } catch(e) {}
    }
  } finally {
    entry.aiEnabled = true; startAIActions(id);
  }
}

function startAIActions(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot) return;
  stopAIActions(id);

  entry.aiIntervals.randomMove = setInterval(() => { if (!entry.aiEnabled || !entry.bot || !entry.bot.pathfinder) return; if (entry.bot.pathfinder.isMoving()) return; randomMove(id); }, 3500 + Math.random()*3000);
  entry.aiIntervals.avoidCheck = setInterval(() => { if (!entry.aiEnabled) return; checkAndAvoidHostiles(id); }, 1500);
  entry.aiIntervals.trySleep = setInterval(() => { if (!entry.aiEnabled) return; trySleepIfNight(id); }, 10000);
}

function stopAIActions(id) {
  const entry = botManager.bots[id];
  if (!entry) return;
  for (const k of Object.keys(entry.aiIntervals)) {
    if (entry.aiIntervals[k]) { clearInterval(entry.aiIntervals[k]); entry.aiIntervals[k] = null; }
  }
}

function randomMove(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot || !entry.bot.entity) return;
  const bot = entry.bot;
  const current = bot.entity.position;
  const rx = current.x + (Math.random() - 0.5) * 8;
  const rz = current.z + (Math.random() - 0.5) * 8;
  const ry = current.y;
  try {
    const mcData = mcDataPkg(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(rx, ry, rz, 1));
  } catch (e) {}
}

async function trySleepIfNight(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot || !entry.bot.time) return;
  const bot = entry.bot;
  const t = bot.time && bot.time.timeOfDay;
  if (!t) return;
  if (t >= 12500 && t <= 23500) {
    const bed = bot.findBlock({ matching: (b) => b && b.name && b.name.includes('bed'), maxDistance: 20 });
    if (bed) {
      try {
        const mcData = mcDataPkg(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
        await bot.sleep(bed.position);
        console.log(`[${id}] slept in bed`);
      } catch (e) {}
    }
  }
}

function checkAndAvoidHostiles(id) {
  const entry = botManager.bots[id];
  if (!entry || !entry.bot || !entry.bot.entity) return;
  const bot = entry.bot;
  const pos = bot.entity.position;
  const entities = Object.values(bot.entities);

  const hostileSet = new Set(['zombie','skeleton','creeper','spider','husk','drowned','witch','zombified_piglin','pillager','evoker','vindication_illager']);
  const hostiles = entities.filter(e => e && e.name && e.position && hostileSet.has((e.name||'').toLowerCase()) && pos.distanceTo(e.position) < 12);
  if (!hostiles.length) return;

  const sampleCount = 12;
  const minDistance = 10;
  const radiusMin = 6;
  const radiusMax = 14;
  let candidates = [];
  for (let i = 0; i < sampleCount; i++) {
    const angle = (i / sampleCount) * Math.PI * 2;
    const dist = radiusMin + Math.random() * (radiusMax - radiusMin);
    const cx = pos.x + Math.cos(angle) * dist;
    const cz = pos.z + Math.sin(angle) * dist;
    let cy = Math.floor(pos.y);
    for (let yOff = 0; yOff > -6; yOff--) {
      const block = bot.blockAt({ x: Math.floor(cx), y: cy + yOff - 1, z: Math.floor(cz) });
      if (block && block.boundingBox === 'block') { cy = cy + yOff; break; }
    }
    let minD = Infinity;
    for (const h of hostiles) {
      if (!h.position) continue;
      const d = Math.sqrt((cx - h.position.x) ** 2 + (cz - h.position.z) ** 2);
      if (d < minD) minD = d;
    }
    candidates.push({ x: cx, y: cy, z: cz, minD });
  }
  candidates.sort((a, b) => b.minD - a.minD);
  const chosen = candidates.find(c => c.minD >= minDistance) || candidates[0];
  if (!chosen) return;
  try {
    const mcData = mcDataPkg(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(chosen.x, chosen.y, chosen.z, 1));
    console.log(`[${id}] running away to (${chosen.x.toFixed(1)},${chosen.y.toFixed(1)},${chosen.z.toFixed(1)})`);
  } catch (e) {
    const nearest = hostiles[0];
    if (nearest && nearest.position) {
      const dx = pos.x - nearest.position.x;
      const dz = pos.z - nearest.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const targetX = pos.x + (dx / len) * 10;
      const targetZ = pos.z + (dz / len) * 10;
      try {
        const mcData = mcDataPkg(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalNear(targetX, pos.y, targetZ, 1));
      } catch (e2) {}
    }
  }
}

// socket.io UI
io.of('/dashboard').on('connection', (socket) => {
  socket.emit('allStates', gatherStates());
  socket.on('createBot', ({ host, port, username }) => { const id = createBot({ host, port, username }); socket.emit('created', { id }); });
  socket.on('takeControl', ({ botId }) => { const e = botManager.bots[botId]; if (!e) return; e.state.controllingClientId = socket.id; e.aiEnabled = false; stopAIActions(botId); emitAllStates(); });
  socket.on('releaseControl', ({ botId }) => { const e = botManager.bots[botId]; if (!e) return; if (e.state.controllingClientId === socket.id) { e.state.controllingClientId = null; e.aiEnabled = true; startAIActions(botId); emitAllStates(); } });
  socket.on('control', ({ botId, data }) => { const e = botManager.bots[botId]; if (!e || !e.bot) return; if (e.state.controllingClientId !== socket.id) return; if (data.type === 'move') e.bot.setControlState(data.key, data.value); else if (data.type === 'look') try { e.bot.look(data.yaw, data.pitch, true); } catch(e) {} });
  socket.on('chat', ({ botId, msg }) => { const e = botManager.bots[botId]; if (!e || !e.bot) return; e.bot.chat(msg); e.state.chat.push(`<you> ${msg}`); if (e.state.chat.length > 300) e.state.chat.shift(); emitAllStates(); });
  socket.on('forceDrop', ({ botId }) => { dropEverything(botId); });
  socket.on('disconnect', () => { for (const id of Object.keys(botManager.bots)) { const e = botManager.bots[id]; if (e.state.controllingClientId === socket.id) { e.state.controllingClientId = null; e.aiEnabled = true; startAIActions(id); } } emitAllStates(); });
});

function gatherStates() { const out = {}; for (const id of Object.keys(botManager.bots)) out[id] = botManager.bots[id].state; return out; }
function emitAllStates() { io.of('/dashboard').emit('allStates', gatherStates()); }

app.get('/', (req,res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/dashboard.html', (req,res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/health', (req,res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Listening on ${PORT}`); });

// create initial bot
createBot({ host: 'Stackables.aternos.me', port: 39639, username: `keeper_${Date.now()}` });

// telemetry loop
setInterval(() => {
  for (const id of Object.keys(botManager.bots)) {
    const entry = botManager.bots[id];
    if (!entry || !entry.bot) continue;
    try {
      entry.state.health = entry.bot.health || entry.state.health;
      entry.state.maxHealth = entry.bot.maxHealth || entry.state.maxHealth;
      entry.state.food = entry.bot.food || entry.state.food;
      if (entry.bot.entity && entry.bot.entity.position) {
        entry.state.position = { x: entry.bot.entity.position.x.toFixed(2), y: entry.bot.entity.position.y.toFixed(2), z: entry.bot.entity.position.z.toFixed(2) };
      }
    } catch (e) {}
  }
  emitAllStates();
}, 1000);
