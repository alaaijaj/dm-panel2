require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection
} = require('@discordjs/voice');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const DATA = path.join(__dirname, 'data');
const SETTINGS = path.join(DATA, 'settings.json');
const USERS = path.join(DATA, 'panel_users.json');
const SUBS = path.join(DATA, 'subscribers.json');
const LOGS = path.join(DATA, 'activity_logs.json');
const WELCOME_AUDIO = path.join(__dirname, 'public', 'welcome.mp3');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function ensure(file, val) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(val, null, 2), 'utf8');
  }
}

ensure(SETTINGS, {
  appName: 'Syria Store',
  developerDiscordId: '',
  monthlyPrice: 9.99,
  currency: 'EUR',
  siteDescription: 'Safe member messaging panel',
  backgroundImageUrl: '',
  blurStrength: 14,
  allowRoleMessagingOnly: true
});
ensure(USERS, [{
  id: '1',
  email: process.env.OWNER_EMAIL || 'owner@example.com',
  password: process.env.OWNER_PASSWORD || 'ChangeMe123!',
  role: 'owner',
  isActive: true
}]);
ensure(SUBS, []);
ensure(LOGS, []);

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');

function addLog(entry) {
  const logs = read(LOGS);
  logs.unshift({
    id: String(Date.now()),
    time: new Date().toISOString(),
    ...entry
  });
  write(LOGS, logs.slice(0, 1000));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 12
  }
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 400 }));

function clean(v = '') {
  return String(v).trim();
}

function me(req) {
  return read(USERS).find(u => u.id === req.session.userId) || null;
}

function auth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function ownerOrAdmin(req, res, next) {
  const u = me(req);
  if (!u || !['owner', 'admin'].includes(u.role)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

function owner(req, res, next) {
  const u = me(req);
  if (!u || u.role !== 'owner') {
    return res.status(403).send('Forbidden');
  }
  next();
}

async function developerProfile() {
  const settings = read(SETTINGS);
  const id =
    settings.developerDiscordId ||
    process.env.DEVELOPER_DISCORD_ID ||
    process.env.OWNER_DISCORD_ID ||
    '';

  if (!id) return null;

  try {
    const u = await client.users.fetch(id);
    return {
      id: u.id,
      username: u.username,
      displayName: u.globalName || u.username,
      avatar: u.displayAvatarURL({ size: 256 })
    };
  } catch {
    return null;
  }
}

async function guildChoices() {
  return client.guilds.cache
    .map(g => ({ id: g.id, name: g.name, members: g.memberCount || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const guildDataCache = new Map();

async function guildData(gid) {
  const now = Date.now();
  const cached = guildDataCache.get(gid);

  if (cached && (now - cached.time) < 30000) {
    return cached.data;
  }

  const guild = await client.guilds.fetch(gid);

  let membersCollection;
  try {
    if (guild.members.cache && guild.members.cache.size > 0) {
      membersCollection = guild.members.cache;
    } else {
      membersCollection = await guild.members.fetch();
    }
  } catch {
    membersCollection = guild.members.cache || new Map();
  }

  const members = [...membersCollection.values()];

  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map(r => ({
      id: r.id,
      name: r.name,
      count: r.members.size
    }));

  const users = members
    .filter(m => m && m.user && !m.user.bot)
    .map(m => ({
      id: m.id,
      label: `${m.user.username} (${m.user.id})`
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const data = { guild, roles, users };
  guildDataCache.set(gid, { time: now, data });

  return data;
}

async function sendSafe({
  actorEmail,
  guildId,
  targetType,
  roleId,
  singleUserId,
  multipleUserIds,
  plainText,
  useEmbed,
  title,
  description,
  color,
  imageUrl,
  footer
}) {
  const settings = read(SETTINGS);

  if (settings.allowRoleMessagingOnly && !['role', 'single', 'multiple'].includes(targetType)) {
    throw new Error('الإرسال إلى الجميع غير متاح في هذه النسخة.');
  }

  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch();
  let targets = [];

  if (targetType === 'single' && singleUserId) {
    const m = members.get(singleUserId);
    if (m && !m.user.bot) targets = [m];
  } else if (targetType === 'multiple' && Array.isArray(multipleUserIds)) {
    targets = multipleUserIds
      .map(id => members.get(id))
      .filter(Boolean)
      .filter(m => !m.user.bot);
  } else if (targetType === 'role' && roleId) {
    targets = members
      .filter(m => !m.user.bot && m.roles.cache.has(roleId))
      .map(m => m);
  } else {
    throw new Error('نوع الاستهداف غير صحيح');
  }

  const payload = {};
  if (useEmbed === 'on') {
    const e = new EmbedBuilder()
      .setColor(color || '#5865F2')
      .setDescription(description || ' ')
      .setTimestamp();

    if (title) e.setTitle(title);
    if (footer) e.setFooter({ text: footer });
    if (imageUrl) e.setImage(imageUrl);

    payload.embeds = [e];
    if (plainText) payload.content = plainText;
  } else {
    payload.content = plainText || description || ' ';
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const member of targets) {
    try {
      await member.send(payload);
      sent++;
    } catch (err) {
      failed++;
      errors.push(`${member.user.tag}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  addLog({
    type: 'message_send',
    actorEmail,
    guildId,
    targetType,
    roleId: roleId || '',
    singleUserId: singleUserId || '',
    multipleCount: Array.isArray(multipleUserIds) ? multipleUserIds.length : 0,
    sent,
    failed,
    title: title || '',
    plainTextPreview: (plainText || description || '').slice(0, 160)
  });

  return {
    totalTargets: targets.length,
    sent,
    failed,
    errors: errors.slice(0, 20)
  };
}

function getTargetGuildId() {
  return process.env.TARGET_GUILD_ID || '';
}

function getTargetVoiceChannelId() {
  return process.env.TARGET_VOICE_CHANNEL_ID || '';
}

const voicePlayer = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause
  }
});

let isPlayingWelcome = false;
let lastWelcomeAt = 0;

async function joinFixedVoiceChannel() {
  const guildId = getTargetGuildId();
  const channelId = getTargetVoiceChannelId();
  if (!guildId || !channelId) return null;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !guild.voiceAdapterCreator) return null;

  let connection = getVoiceConnection(guildId);
  if (connection && connection.joinConfig.channelId === channelId) {
    return connection;
  }

  if (connection) {
    try { connection.destroy(); } catch {}
  }

  connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (err) {
    console.error('Voice connection failed:', err.message);
    try { connection.destroy(); } catch {}
    return null;
  }

  connection.subscribe(voicePlayer);
  console.log(`Joined fixed voice channel: ${channelId}`);
  return connection;
}

async function ensureFixedVoiceChannel() {
  const guildId = getTargetGuildId();
  const channelId = getTargetVoiceChannelId();
  if (!guildId || !channelId) return;

  const connection = getVoiceConnection(guildId);
  if (!connection || connection.joinConfig.channelId !== channelId) {
    await joinFixedVoiceChannel();
  }
}

async function playWelcomeVoice() {
  if (!fs.existsSync(WELCOME_AUDIO)) {
    console.log('welcome.mp3 not found, skipping voice welcome.');
    return;
  }

  if (isPlayingWelcome) return;
  if (Date.now() - lastWelcomeAt < 4000) return;

  const guildId = getTargetGuildId();
  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  try {
    isPlayingWelcome = true;
    lastWelcomeAt = Date.now();

    const resource = createAudioResource(WELCOME_AUDIO);
    voicePlayer.play(resource);

    await entersState(voicePlayer, 'playing', 5000).catch(() => {});
  } catch (err) {
    console.error('Welcome voice playback failed:', err.message);
  } finally {
    setTimeout(() => {
      isPlayingWelcome = false;
    }, 5000);
  }
}

app.get('/login', async (req, res) => {
  res.render('login', {
    error: null,
    settings: read(SETTINGS),
    developer: await developerProfile()
  });
});

app.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 25 }), async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = clean(req.body.password);

  const user = read(USERS).find(
    u => clean(u.email).toLowerCase() === email &&
         clean(u.password) === password &&
         u.isActive
  );

  if (!user) {
    return res.render('login', {
      error: 'بيانات الدخول غير صحيحة.',
      settings: read(SETTINGS),
      developer: await developerProfile()
    });
  }

  req.session.userId = user.id;
  addLog({ type: 'login', actorEmail: user.email, message: 'Panel login success' });
  res.redirect('/');
});

app.get('/logout', auth, (req, res) => {
  const u = me(req);
  if (u) addLog({ type: 'logout', actorEmail: u.email, message: 'Panel logout' });
  req.session.destroy(() => res.redirect('/login'));
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const botId = client.user ? client.user.id : null;
  const targetGuildId = getTargetGuildId();
  const targetChannelId = getTargetVoiceChannelId();

  if (botId && oldState.id === botId) {
    const leftTargetRoom =
      oldState.guild.id === targetGuildId &&
      oldState.channelId === targetChannelId &&
      newState.channelId !== targetChannelId;

    if (leftTargetRoom) {
      setTimeout(() => {
        ensureFixedVoiceChannel().catch(err => console.error('Rejoin failed:', err.message));
      }, 2500);
    }
  }

  if (!newState.member || newState.member.user.bot) return;
  if (newState.guild.id !== targetGuildId) return;
  if (oldState.channelId === targetChannelId) return;
  if (newState.channelId !== targetChannelId) return;

  await ensureFixedVoiceChannel();
  await playWelcomeVoice();
});

client.once('ready', async () => {
  console.log(`Bot ready as ${client.user.tag}`);
  await ensureFixedVoiceChannel();
  setInterval(() => {
    ensureFixedVoiceChannel().catch(err => console.error('Voice keepalive failed:', err.message));
  }, 30000);
});

client.login(process.env.BOT_TOKEN);
app.listen(PORT, () => console.log(`Panel: http://localhost:${PORT}`));
